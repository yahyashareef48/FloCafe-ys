package com.albaik.pos;

import android.Manifest;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Raw ESC/POS transport for printers attached to the tablet: USB (Android USB
 * Host, bulk OUT endpoint) and Bluetooth (classic SPP / RFCOMM). A printer is
 * addressed by the name discovery gave it, e.g. "SR588 (USB 0483:5720)" or
 * "SR588 (Bluetooth 66:22:33:44:55:66)", which is what Settings > Printers saves.
 */
final class PrinterHub {
    private static final String TAG = "AlBaikPrinters";
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String ACTION_USB_PERMISSION = "com.albaik.pos.USB_PERMISSION";
    private static final Pattern USB_NAME = Pattern.compile("\\(USB ([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})\\)\\s*$");
    private static final Pattern BLUETOOTH_NAME = Pattern.compile("\\(Bluetooth ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\\)\\s*$");
    private static final Pattern PRINTER_LIKE_NAME = Pattern.compile("(?i)print|pos|thermal|receipt|rpp|mtp|sr\\d|pt-|zj|xp-");
    private static final int USB_CHUNK_BYTES = 16 * 1024;
    private static final int USB_TIMEOUT_MS = 10_000;
    private static final int BLUETOOTH_CHUNK_BYTES = 1024;

    private final Context context;
    // One job at a time: printers do not interleave two jobs, and USB claims are exclusive.
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    PrinterHub(Context context) {
        this.context = context.getApplicationContext();
    }

    void register(ShellBridge bridge) {
        bridge.registerServiceHandler("printerList", (method, params, reply) -> io.execute(() -> guarded(reply, () -> list(reply))));
        bridge.registerServiceHandler("printerSend", (method, params, reply) -> io.execute(() -> guarded(reply, () -> send(params, reply))));
    }

    /** An exception on the print thread would end the whole app; report it to the caller instead. */
    private static void guarded(ShellBridge.Reply reply, Runnable job) {
        try {
            job.run();
        } catch (Throwable e) {
            Log.e(TAG, "Printer job failed", e);
            reply.error("Printer error: " + e);
        }
    }

    // ---- Discovery -------------------------------------------------------------

    private void list(ShellBridge.Reply reply) {
        JSONArray printers = new JSONArray();
        try {
            for (UsbDevice device : usbManager().getDeviceList().values()) {
                if (bulkOut(device) == null) continue;
                printers.put(new JSONObject()
                    .put("name", usbName(device))
                    .put("make", nonNull(safeManufacturer(device)))
                    .put("model", nonNull(safeProduct(device)))
                    .put("connectionType", "usb")
                    .put("deviceUri", String.format(Locale.ROOT, "usb://%04X/%04X", device.getVendorId(), device.getProductId())));
            }
            for (BluetoothDevice device : bondedPrinters()) {
                printers.put(new JSONObject()
                    .put("name", bluetoothName(device))
                    .put("make", "")
                    .put("model", nonNull(safeBluetoothName(device)))
                    .put("connectionType", "bluetooth")
                    .put("deviceUri", "bt://" + device.getAddress()));
            }
            reply.success(printers);
        } catch (Exception e) {
            Log.e(TAG, "Printer discovery failed", e);
            reply.error("Printer discovery failed: " + e.getMessage());
        }
    }

    private List<BluetoothDevice> bondedPrinters() {
        List<BluetoothDevice> printers = new ArrayList<>();
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null || !hasBluetoothPermission()) return printers;
        try {
            for (BluetoothDevice device : adapter.getBondedDevices()) {
                if (looksLikePrinter(device)) printers.add(device);
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Bluetooth permission was revoked", e);
        }
        return printers;
    }

    private boolean looksLikePrinter(BluetoothDevice device) {
        BluetoothClass type = device.getBluetoothClass();
        if (type != null && type.getMajorDeviceClass() == BluetoothClass.Device.Major.IMAGING) return true;
        ParcelUuid[] uuids = device.getUuids();
        if (uuids != null) {
            for (ParcelUuid uuid : uuids) if (SPP.equals(uuid.getUuid())) return true;
        }
        String name = safeBluetoothName(device);
        return name != null && PRINTER_LIKE_NAME.matcher(name).find();
    }

    // ---- Printing --------------------------------------------------------------

    private void send(JSONObject params, ShellBridge.Reply reply) {
        String name = params.optString("name");
        byte[] data = Base64.decode(params.optString("data"), Base64.DEFAULT);
        String failure;
        try {
            Matcher bluetooth = BLUETOOTH_NAME.matcher(name);
            Matcher usb = USB_NAME.matcher(name);
            if (bluetooth.find()) {
                failure = sendBluetooth(bluetooth.group(1).toUpperCase(Locale.ROOT), data);
            } else if (usb.find()) {
                failure = sendUsb(findUsb(Integer.parseInt(usb.group(1), 16), Integer.parseInt(usb.group(2), 16)), name, data);
            } else {
                // A printer saved on Windows keeps its spooler name; use the one attached USB printer.
                List<UsbDevice> attached = attachedUsbPrinters();
                failure = attached.size() == 1
                    ? sendUsb(attached.get(0), name, data)
                    : "\"" + name + "\" is not a USB or Bluetooth printer on this tablet. Open Settings > Printers, detect printers, and select it again.";
            }
        } catch (Exception e) {
            Log.e(TAG, "Print to " + name + " failed", e);
            failure = String.valueOf(e.getMessage());
        }
        try {
            JSONObject result = new JSONObject().put("ok", failure == null);
            if (failure != null) result.put("detail", failure);
            reply.success(result);
        } catch (Exception e) {
            reply.error(String.valueOf(e.getMessage()));
        }
    }

    private List<UsbDevice> attachedUsbPrinters() {
        List<UsbDevice> printers = new ArrayList<>();
        for (UsbDevice device : usbManager().getDeviceList().values()) {
            if (bulkOut(device) != null) printers.add(device);
        }
        return printers;
    }

    private UsbDevice findUsb(int vendorId, int productId) {
        for (UsbDevice device : usbManager().getDeviceList().values()) {
            if (device.getVendorId() == vendorId && device.getProductId() == productId && bulkOut(device) != null) return device;
        }
        return null;
    }

    /** Returns null on success, otherwise a message for the operator. */
    private String sendUsb(UsbDevice device, String name, byte[] data) throws InterruptedException {
        if (device == null) return "The USB printer \"" + name + "\" is not connected. Check the cable and that the printer is on.";
        UsbManager manager = usbManager();
        if (!manager.hasPermission(device) && !requestUsbPermission(device)) {
            return "Al Baik POS was not allowed to use the USB printer. Reconnect it and tap Allow (tick \"Always\").";
        }
        UsbEndpointPair target = bulkOut(device);
        if (target == null) return "The USB device has no printer output endpoint.";
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) return "Could not open the USB printer.";
        try {
            if (!connection.claimInterface(target.usbInterface, true)) return "The USB printer is busy.";
            try {
                int offset = 0;
                while (offset < data.length) {
                    int length = Math.min(USB_CHUNK_BYTES, data.length - offset);
                    int written = connection.bulkTransfer(target.endpoint, data, offset, length, USB_TIMEOUT_MS);
                    if (written <= 0) return "The USB printer stopped accepting data (paper out or cover open?).";
                    offset += written;
                }
                return null;
            } finally {
                connection.releaseInterface(target.usbInterface);
            }
        } finally {
            connection.close();
        }
    }

    private boolean requestUsbPermission(UsbDevice device) throws InterruptedException {
        CountDownLatch answered = new CountDownLatch(1);
        AtomicBoolean granted = new AtomicBoolean(false);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                granted.set(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
                answered.countDown();
            }
        };
        ContextCompat.registerReceiver(context, receiver, new IntentFilter(ACTION_USB_PERMISSION), ContextCompat.RECEIVER_NOT_EXPORTED);
        try {
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            Intent intent = new Intent(ACTION_USB_PERMISSION).setPackage(context.getPackageName());
            usbManager().requestPermission(device, PendingIntent.getBroadcast(context, 0, intent, flags));
            answered.await(90, TimeUnit.SECONDS);
            return granted.get();
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    /** Returns null on success, otherwise a message for the operator. */
    private String sendBluetooth(String address, byte[] data) throws InterruptedException {
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null) return "This tablet has no Bluetooth.";
        if (!hasBluetoothPermission()) return "Allow Al Baik POS to use nearby devices (Bluetooth) in Android settings.";
        try {
            if (!adapter.isEnabled()) return "Bluetooth is off. Turn it on and print again.";
            adapter.cancelDiscovery();
            BluetoothDevice device = adapter.getRemoteDevice(address);
            BluetoothSocket socket = connectSpp(device);
            try (OutputStream out = socket.getOutputStream()) {
                for (int offset = 0; offset < data.length; offset += BLUETOOTH_CHUNK_BYTES) {
                    out.write(data, offset, Math.min(BLUETOOTH_CHUNK_BYTES, data.length - offset));
                    out.flush();
                }
                // Closing at once can drop the tail the printer has not read yet.
                Thread.sleep(400);
            } finally {
                socket.close();
            }
            return null;
        } catch (IOException e) {
            return "Could not reach the Bluetooth printer " + address + ". Check that it is on and paired. (" + e.getMessage() + ")";
        } catch (SecurityException e) {
            return "Allow Al Baik POS to use nearby devices (Bluetooth) in Android settings.";
        }
    }

    private BluetoothSocket connectSpp(BluetoothDevice device) throws IOException {
        BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP);
        try {
            socket.connect();
            return socket;
        } catch (IOException secureFailed) {
            socket.close();
            BluetoothSocket insecure = device.createInsecureRfcommSocketToServiceRecord(SPP);
            insecure.connect();
            return insecure;
        }
    }

    // ---- Helpers ---------------------------------------------------------------

    private static final class UsbEndpointPair {
        final UsbInterface usbInterface;
        final UsbEndpoint endpoint;

        UsbEndpointPair(UsbInterface usbInterface, UsbEndpoint endpoint) {
            this.usbInterface = usbInterface;
            this.endpoint = endpoint;
        }
    }

    /** Prefers a printer-class interface; accepts a vendor-specific one, as many ESC/POS printers use. */
    private static UsbEndpointPair bulkOut(UsbDevice device) {
        UsbEndpointPair fallback = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface usbInterface = device.getInterface(i);
            int type = usbInterface.getInterfaceClass();
            if (type != UsbConstants.USB_CLASS_PRINTER && type != UsbConstants.USB_CLASS_VENDOR_SPEC) continue;
            for (int e = 0; e < usbInterface.getEndpointCount(); e++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(e);
                if (endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && endpoint.getDirection() == UsbConstants.USB_DIR_OUT) {
                    UsbEndpointPair pair = new UsbEndpointPair(usbInterface, endpoint);
                    if (type == UsbConstants.USB_CLASS_PRINTER) return pair;
                    if (fallback == null) fallback = pair;
                }
            }
        }
        return fallback;
    }

    private static String usbName(UsbDevice device) {
        String product = safeProduct(device);
        String label = product == null || product.trim().isEmpty() ? "USB printer" : product.trim();
        return String.format(Locale.ROOT, "%s (USB %04X:%04X)", label, device.getVendorId(), device.getProductId());
    }

    private String bluetoothName(BluetoothDevice device) {
        String name = safeBluetoothName(device);
        String label = name == null || name.trim().isEmpty() ? "Bluetooth printer" : name.trim();
        return label + " (Bluetooth " + device.getAddress() + ")";
    }

    private static String safeProduct(UsbDevice device) {
        try {
            return device.getProductName();
        } catch (SecurityException e) {
            return null;
        }
    }

    private static String safeManufacturer(UsbDevice device) {
        try {
            return device.getManufacturerName();
        } catch (SecurityException e) {
            return null;
        }
    }

    private String safeBluetoothName(BluetoothDevice device) {
        try {
            return hasBluetoothPermission() ? device.getName() : null;
        } catch (SecurityException e) {
            return null;
        }
    }

    private static String nonNull(String value) {
        return value == null ? "" : value;
    }

    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private UsbManager usbManager() {
        return (UsbManager) context.getSystemService(Context.USB_SERVICE);
    }

    private BluetoothAdapter bluetoothAdapter() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }
}
