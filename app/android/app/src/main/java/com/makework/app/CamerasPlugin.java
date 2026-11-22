package com.makework.app;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// The system's cameras and which of them an app can open (src/voice/cameras.ts). The WebView lists every camera id,
// also depth and infrared sensors that only give data, and its device ids change with every launch. Reading a
// camera's characteristics needs no camera permission.
@CapacitorPlugin(name = "Cameras")
public class CamerasPlugin extends Plugin {
    @PluginMethod
    public void list(PluginCall call) {
        CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            call.reject("This device has no camera service.");
            return;
        }
        try {
            JSArray cameras = new JSArray();
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
                JSObject camera = new JSObject();
                camera.put("id", id);
                camera.put("facing", facing(characteristics.get(CameraCharacteristics.LENS_FACING)));
                camera.put("usable", givesPictures(characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)));
                cameras.put(camera);
            }
            JSObject result = new JSObject();
            result.put("cameras", cameras);
            call.resolve(result);
        } catch (CameraAccessException | IllegalArgumentException e) {
            call.reject("The cameras couldn't be listed.", e);
        }
    }

    private static String facing(Integer lens) {
        if (lens == null) return "external";
        if (lens == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (lens == CameraCharacteristics.LENS_FACING_BACK) return "back";
        return "external";
    }

    // Cameras without this capability (depth, infrared) can't stream a picture to the WebView.
    private static boolean givesPictures(int[] capabilities) {
        if (capabilities == null) return false;
        for (int capability : capabilities) {
            if (capability == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE) return true;
        }
        return false;
    }
}
