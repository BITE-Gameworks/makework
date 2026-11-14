package com.makework.app;

import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Opens a sign-in page in a Custom Tab and hands the app the link it comes back on (the intent filter in
// AndroidManifest.xml). Sign-in pages can't run inside the app's WebView: the answer has to come back to the app.
@CapacitorPlugin(name = "SignInBrowser")
public class SignInBrowserPlugin extends Plugin {
    private static final String returnScheme = "com.makework.app";

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("An https address is needed.");
            return;
        }
        new CustomTabsIntent.Builder().build().launchUrl(getActivity(), Uri.parse(url));
        call.resolve();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent.getData();
        if (!Intent.ACTION_VIEW.equals(intent.getAction()) || data == null || !returnScheme.equals(data.getScheme())) return;
        JSObject event = new JSObject();
        event.put("url", data.toString());
        notifyListeners("returned", event);
    }
}
