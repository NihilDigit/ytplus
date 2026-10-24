package dev.nihildigit.ytplus.xposed

import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Member
import java.lang.reflect.Method
import io.github.libxposed.api.XposedInterface
import java.util.concurrent.ConcurrentHashMap

/** Keeps all API-101 interceptor reflection in one place, failing closed on incompatible APIs. */
internal class HookInstaller(private val module: XposedInterface) {
    private val installed = ConcurrentHashMap.newKeySet<Member>()

    fun after(method: Method, callback: (Any?, Array<Any?>, Any?) -> Unit) = around(method) { receiver, args, proceed ->
        val result = proceed()
        try { callback(receiver, args, result) } catch (error: Throwable) { RuntimeBridge.log("Hook observer failed", error) }
        result
    }

    fun around(method: Method, callback: (Any?, Array<Any?>, () -> Any?) -> Any?) {
        if (!installed.add(method)) return
        try {
            module.hook(method).intercept(XposedInterface.Hooker { chain ->
                callback(chain.thisObject, chain.args.toTypedArray()) { chain.proceed() }
            })
        } catch (error: Throwable) {
            installed.remove(method)
            RuntimeBridge.log("Cannot install ${method.declaringClass.name}.${method.name}", error)
        }
    }

    companion object {
        fun property(instance: Any, vararg names: String): Any? = instance.javaClass.methods
            .firstOrNull { it.name in names && it.parameterCount == 0 }?.let { invoke(it, instance) }
        fun invoke(method: Method, receiver: Any?, vararg args: Any?): Any? {
            try { method.isAccessible = true; return method.invoke(receiver, *args) }
            catch (error: InvocationTargetException) { throw error.targetException }
        }
    }
}
