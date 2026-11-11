/// Closed native media observations. No upstream strings, locators, payloads,
/// metadata, NSError descriptions or userInfo can cross this callback contract.
public enum NativeMediaDiagnostic: Sendable {
    case loading(offset: Int64, length: Int, toEnd: Bool, information: Bool)
    case contentTypes(m4a: Bool, mp4: Bool, mpeg4Audio: Bool, unrestricted: Bool)
    case delivered(Int)
    case cancelled
    case failure(PlaybackFailure)
    case status(Int)
    case error(domain: NativeMediaErrorDomain, code: Int)
}

public enum NativeMediaErrorDomain: String, Sendable {
    case avFoundation, url, osStatus, coreMedia, other
}
