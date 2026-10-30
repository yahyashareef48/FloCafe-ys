package com.albaik.pos;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

final class IoUtil {
    private IoUtil() {}

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
    }

    static byte[] readFully(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copy(in, out);
        return out.toByteArray();
    }

    static byte[] readFile(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            return readFully(in);
        }
    }

    /** Writes through a temporary file so a crash never leaves a half-written file behind. */
    static void writeFileAtomically(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Cannot create " + parent);
        }
        File temp = new File(file.getPath() + ".tmp");
        try (OutputStream out = new FileOutputStream(temp)) {
            out.write(data);
            out.flush();
        }
        if (!temp.renameTo(file)) throw new IOException("Cannot replace " + file);
    }

    static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** Keeps only characters that are safe in a file name on every Android filesystem. */
    static String safeFileName(String name, String fallback) {
        String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._ -]+", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) return fallback;
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }
}
