package com.albaik.pos;

import android.app.Activity;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Prints an HTML document through Android's print service (system printers or
 * "Save as PDF"). The callback runs once the print dialog has closed.
 */
final class HtmlPrinter {
    private HtmlPrinter() {}

    static void print(Activity activity, String html, String baseUrl, String jobName, Runnable onFinished) {
        WebView renderer = new WebView(activity);
        renderer.getSettings().setJavaScriptEnabled(false);
        renderer.setWebViewClient(new WebViewClient() {
            private boolean started;

            @Override
            public void onPageFinished(WebView view, String url) {
                if (started) return;
                started = true;
                PrintManager printManager = (PrintManager) activity.getSystemService(Activity.PRINT_SERVICE);
                PrintDocumentAdapter adapter = new FinishNotifyingAdapter(view.createPrintDocumentAdapter(jobName), () -> {
                    view.destroy();
                    onFinished.run();
                });
                printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Unhandled, a lost renderer ends the whole app.
                Log.e("AlBaikPrint", "Print renderer stopped (crashed: " + detail.didCrash() + ")");
                view.destroy();
                if (!started) {
                    started = true;
                    onFinished.run();
                }
                return true;
            }
        });
        renderer.loadDataWithBaseURL(baseUrl, html, "text/html", "UTF-8", null);
    }

    private static final class FinishNotifyingAdapter extends PrintDocumentAdapter {
        private final PrintDocumentAdapter delegate;
        private final Runnable onFinished;

        FinishNotifyingAdapter(PrintDocumentAdapter delegate, Runnable onFinished) {
            this.delegate = delegate;
            this.onFinished = onFinished;
        }

        @Override
        public void onStart() {
            delegate.onStart();
        }

        @Override
        public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellationSignal,
                             LayoutResultCallback callback, Bundle extras) {
            delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
        }

        @Override
        public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal,
                            WriteResultCallback callback) {
            delegate.onWrite(pages, destination, cancellationSignal, callback);
        }

        @Override
        public void onFinish() {
            delegate.onFinish();
            onFinished.run();
        }
    }
}
