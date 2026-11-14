package com.makework.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleSignInPlugin.class);
        registerPlugin(SignInBrowserPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
