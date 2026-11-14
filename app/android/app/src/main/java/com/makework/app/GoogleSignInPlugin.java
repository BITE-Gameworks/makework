package com.makework.app;

import android.accounts.Account;
import android.app.Activity;
import android.os.CancellationSignal;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.util.ArrayList;
import java.util.List;

// Sign in with Google through Android's Credential Manager (the ID token), then Google's authorization client (the
// access token for the requested scopes, for the same account). Google matches the app by its package name and
// signing certificate, so the client ID passed in is the web client's.
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {
    private static final String cancelled = "Sign-in was cancelled.";

    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall waiting;
    private String waitingIdToken;

    @Override
    public void load() {
        // Must be registered before the activity starts, which is when Capacitor loads plugins.
        consent = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::consentDone);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = call.getString("clientId");
        String nonce = call.getString("nonce");
        if (clientId == null || nonce == null) {
            call.reject("clientId and nonce are needed.");
            return;
        }
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(clientId).setNonce(nonce).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager.create(getContext()).getCredentialAsync(getActivity(), request, new CancellationSignal(),
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    signedIn(call, response.getCredential());
                }

                @Override
                public void onError(GetCredentialException e) {
                    call.reject(e instanceof GetCredentialCancellationException ? cancelled : "Google said: " + e.getMessage());
                }
            });
    }

    private void signedIn(PluginCall call, Credential credential) {
        if (!(credential instanceof CustomCredential)
            || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
            call.reject("Google sent an unexpected kind of sign-in.");
            return;
        }
        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
        authorize(call, google.getIdToken(), google.getId());
    }

    private void authorize(PluginCall call, String idToken, String email) {
        List<Scope> scopes = new ArrayList<>();
        try {
            JSArray requested = call.getArray("scopes", new JSArray());
            for (int i = 0; i < requested.length(); i++) scopes.add(new Scope(requested.getString(i)));
        } catch (org.json.JSONException e) {
            call.reject("scopes must be a list of strings.");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder()
            .setRequestedScopes(scopes)
            .setAccount(new Account(email, "com.google"))
            .build();
        Identity.getAuthorizationClient(getActivity()).authorize(request)
            .addOnSuccessListener(result -> {
                if (result.hasResolution() && result.getPendingIntent() != null) {
                    waiting = call;
                    waitingIdToken = idToken;
                    consent.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                } else {
                    resolve(call, idToken, result);
                }
            })
            .addOnFailureListener(e -> call.reject("Google said: " + e.getMessage()));
    }

    private void consentDone(ActivityResult activityResult) {
        PluginCall call = waiting;
        String idToken = waitingIdToken;
        waiting = null;
        waitingIdToken = null;
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK) {
            call.reject(cancelled);
            return;
        }
        try {
            resolve(call, idToken, Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(activityResult.getData()));
        } catch (ApiException e) {
            call.reject("Google said: " + e.getMessage());
        }
    }

    private void resolve(PluginCall call, String idToken, AuthorizationResult result) {
        if (result.getAccessToken() == null) {
            call.reject("Google gave no access to Drive.");
            return;
        }
        JSObject answer = new JSObject();
        answer.put("idToken", idToken);
        answer.put("accessToken", result.getAccessToken());
        call.resolve(answer);
    }
}
