import Foundation
import AureliaQuack

// Original tiny fixture using the same public syntax exercised by upstream tests.
let fixture = """
var g={};
var table='V;prototype;get;set'.split(';');
var sig=function(x){return x.split('').reverse().join('');};
g.C=function(raw,enabled){this.raw=raw;this.enabled=enabled;this[table[0]]={};};
g.C[table[1]][table[3]]=function(k,v){this.V[k]=v;};
g.C[table[1]][table[2]]=function(k){applyN(7,19,this);return this.V[k];};
var applyN=function(a,b,o){var key=a^b;if(key==20){o.set('n',o.V.n.split('').reverse().join(''));}};
var decode=function(a,b,x){return x;};
var landmark=function(M,k,X){M=new g.C(M,!0);M.set("alr","yes");X&&(X=sig2(11,3932,decode(3,673,X)));};
var sig2=function(a,b,x){return sig(x);};
var settings={signatureTimestamp:20724};
"""

func require(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { fatalError("Fixed cipher check failed: \(label)") }
}

func exerciseCipher(_ fixture: String) {
require(!Thread.isMainThread, "off-main-worker")
let compilation = QuackCipherFactory.shared.compile(playerJavaScript: fixture)
require(compilation.status.name == "OK", "compile")
guard let program = compilation.program else { fatalError("Fixed cipher check failed: program") }
require(program.signatureTimestamp?.intValue == 20724, "timestamp")
for _ in 0..<3 {
    let solved = program.solve(signature: "abcdef", n: "123xyz")
    require(solved.status.name == "OK" && solved.signature == "fedcba" && solved.n == "zyx321", "transform")
}
let onlyN = program.solve(signature: nil, n: "abc")
require(onlyN.status.name == "OK" && onlyN.signature == nil && onlyN.n == "cba", "n-only")
require(program.solve(signature: nil, n: nil).status.name == "INVALID_INPUT", "empty-request")
require(program.solve(signature: String(repeating: "x", count: 16_385), n: nil).status.name == "INVALID_INPUT", "input-bound")
require(QuackCipherFactory.shared.compile(playerJavaScript: "while(true){}").status.name == "UNSUPPORTED_PLAYER", "unsupported")
require(QuackCipherFactory.shared.compile(playerJavaScript: "").status.name == "INVALID_INPUT", "source-empty")
require(QuackCipherFactory.shared.compile(playerJavaScript: String(repeating: "x", count: 8 * 1024 * 1024 + 1)).status.name == "INVALID_INPUT", "source-bound")
let exhausted = fixture.replacingOccurrences(of: "return x.split('').reverse().join('');", with: "while(true){}return x;")
require(QuackCipherFactory.shared.compile(playerJavaScript: exhausted).status.name == "UNSUPPORTED_PLAYER", "step-budget")
print("PASS Swift static Quack interop: compile, signatureTimestamp, sig/n, repeated calls, bounds, finite-step failure.")
}

let done = DispatchSemaphore(value: 0)
DispatchQueue.global(qos: .userInitiated).async { [fixture, done] in
    exerciseCipher(fixture)
    done.signal()
}
done.wait()
