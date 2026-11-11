package com.lattelix.aurelia.cloudsession;

/** Fixed public error categories only; never chain transport or credential exceptions. */
final class CloudFailure extends Exception {
    final String code;
    CloudFailure(String code) { super(code); this.code = code; }
}
