package com.lattelix.aurelia.quack

import meow.nyx.quackjs.PlayerProgram
import meow.nyx.quackjs.UnsupportedPlayerException

/** Closed error vocabulary. No source, challenge, URL or upstream exception text crosses this API. */
public enum class CipherStatus { OK, INVALID_INPUT, UNSUPPORTED_PLAYER, INTERNAL_FAILURE }

public class CipherSolution internal constructor(
    public val status: CipherStatus,
    public val signature: String?,
    public val n: String?,
)

public class CipherCompilation internal constructor(
    public val status: CipherStatus,
    public val program: CompiledCipher?,
)

/** Immutable compiled program. Calls are synchronous; the Swift host must admit one off-main job. */
public class CompiledCipher internal constructor(private val program: PlayerProgram) {
    public val signatureTimestamp: Int? get() = program.signatureTimestamp

    public fun solve(signature: String?, n: String?): CipherSolution {
        if ((signature == null && n == null) ||
            (signature != null && (signature.isEmpty() || signature.length > 16_384)) ||
            (n != null && (n.isEmpty() || n.length > 16_384))) {
            return CipherSolution(CipherStatus.INVALID_INPUT, null, null)
        }
        return try {
            val decodedSignature = signature?.let(program::decipherSignature)
            val decodedN = n?.let(program::transformN)
            if ((decodedSignature != null && (decodedSignature.isEmpty() || decodedSignature.length > 65_536)) ||
                (decodedN != null && (decodedN.isEmpty() || decodedN.length > 65_536))) {
                CipherSolution(CipherStatus.UNSUPPORTED_PLAYER, null, null)
            } else CipherSolution(CipherStatus.OK, decodedSignature, decodedN)
        } catch (_: UnsupportedPlayerException) {
            CipherSolution(CipherStatus.UNSUPPORTED_PLAYER, null, null)
        } catch (_: Exception) {
            CipherSolution(CipherStatus.INTERNAL_FAILURE, null, null)
        }
    }
}

public object QuackCipherFactory {
    public fun compile(playerJavaScript: String): CipherCompilation {
        if (playerJavaScript.isEmpty() || playerJavaScript.length > 8 * 1024 * 1024) {
            return CipherCompilation(CipherStatus.INVALID_INPUT, null)
        }
        return try {
            CipherCompilation(CipherStatus.OK, CompiledCipher(PlayerProgram.compile(playerJavaScript)))
        } catch (_: UnsupportedPlayerException) {
            CipherCompilation(CipherStatus.UNSUPPORTED_PLAYER, null)
        } catch (_: Exception) {
            CipherCompilation(CipherStatus.INTERNAL_FAILURE, null)
        }
    }
}
