/// Numeric HTTP observations only. No locator, headers, body or raw error is
/// retained or exposed; redirects remain refused by both transports.
public enum YouTubeHTTPDiagnostic: Sendable {
    case response(status: Int)
    case redirect(status: Int)
}
