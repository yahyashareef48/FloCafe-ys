#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

static const char *kTag = "AlBaikNode";
static int outPipe[2];
static int errPipe[2];

static void *pump(void *arg) {
    const int fd = *static_cast<int *>(arg);
    const int prio = fd == errPipe[0] ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, kTag, buf);
    }
    return nullptr;
}

static void redirectStdio() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(outPipe);
    pipe(errPipe);
    dup2(outPipe[1], STDOUT_FILENO);
    dup2(errPipe[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, pump, &outPipe[0]);
    pthread_create(&t2, nullptr, pump, &errPipe[0]);
    pthread_detach(t1);
    pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_albaik_pos_NodeRuntime_startNode(JNIEnv *env, jclass, jobjectArray args, jobjectArray envPairs) {
    const jsize envCount = env->GetArrayLength(envPairs);
    for (jsize i = 0; i + 1 < envCount; i += 2) {
        auto k = (jstring) env->GetObjectArrayElement(envPairs, i);
        auto v = (jstring) env->GetObjectArrayElement(envPairs, i + 1);
        const char *ks = env->GetStringUTFChars(k, nullptr);
        const char *vs = env->GetStringUTFChars(v, nullptr);
        setenv(ks, vs, 1);
        env->ReleaseStringUTFChars(k, ks);
        env->ReleaseStringUTFChars(v, vs);
    }

    // node::Start expects argv strings to live in one contiguous buffer.
    std::vector<std::string> parts;
    const jsize argc = env->GetArrayLength(args);
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto a = (jstring) env->GetObjectArrayElement(args, i);
        const char *s = env->GetStringUTFChars(a, nullptr);
        parts.emplace_back(s);
        total += parts.back().size() + 1;
        env->ReleaseStringUTFChars(a, s);
    }
    char *buffer = static_cast<char *>(calloc(total, 1));
    std::vector<char *> argv;
    char *cursor = buffer;
    for (const auto &p : parts) {
        memcpy(cursor, p.c_str(), p.size() + 1);
        argv.push_back(cursor);
        cursor += p.size() + 1;
    }

    redirectStdio();
    const int code = node::Start(static_cast<int>(argv.size()), argv.data());
    free(buffer);
    return code;
}
