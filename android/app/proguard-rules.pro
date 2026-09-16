# JARVIS Companion — R8 / ProGuard rules.

# Gson: keep the JSON wire models used by Gson (reflection-based serialization).
-keep class com.jarvis.companion.model.** { *; }
-keepattributes Signature

# OkHttp internals required at runtime on some devices.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**