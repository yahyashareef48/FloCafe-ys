package com.albaik.pos;

import org.json.JSONException;
import org.json.JSONObject;

/** JSONObject.put throws a checked exception; this keeps one-line results readable. */
final class Json {
    private Json() {}

    static JSONObject of(String key, Object value) {
        try {
            return new JSONObject().put(key, value);
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
    }
}
