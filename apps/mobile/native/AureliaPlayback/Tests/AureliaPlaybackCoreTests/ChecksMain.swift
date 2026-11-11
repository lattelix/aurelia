import Foundation
import Darwin

@main
struct ChecksMain {
    @MainActor
    static func main() async {
        if CommandLine.arguments.dropFirst() == ["--http-live"] {
            if !(await httpOnlyLiveCheck()) { exit(EXIT_FAILURE) }
            return
        }
        let suite = NativePlaybackTests()
        let checks: [(String, @MainActor () async throws -> Void)] = [
            ("offline_integrity_owner_privacy", { try await checkOfflineIntegrityOwnerAndPrivacy() }),
            ("offline_resume_identity_ranges", { try await checkOfflineResumeIdentityAndRangeGuard() }),
            ("offline_scopes_storage", { try await checkOfflineScopesAndStorageAdmission() }),
            ("offline_controller_stream_transition", { try await checkOfflineControllerTransition() }),
            ("offline_assets_cold_owner_integrity_bounds", { try await checkOfflineAssetsContracts() }),
            ("local_audio_library", { try await runLocalAudioLibraryChecks() }),
            ("verified_youtube_stream_leases", { try checkVerifiedYouTubeStreamLeases() }),
            ("guarded_youtube_byte_source", { try await checkGuardedYouTubeByteSource() }),
            ("validated_range_cache_coverage", { try checkValidatedRangeCacheCoverage() }),
            ("validated_range_cache_bounds", { try checkValidatedRangeCacheBounds() }),
            ("validated_range_cache_lru", { try checkValidatedRangeCacheLRU() }),
            ("validated_range_cache_ownership_reset", { try checkValidatedRangeCacheOwnershipAndReset() }),
            ("validated_range_cache_invariants", { try checkValidatedRangeCacheInvariants() }),
            ("validated_byte_source_cache_guards", { try await checkValidatedByteSourceCache() }),
            ("portable_youtube_source", { try await checkPortableSourceContracts() }),
            ("controller_youtube_lease_continuity", { try await checkControllerLeaseContinuity() }),
            ("queue_edit_retains_load_and_intent", { try await suite.testQueueEditPreservesCurrentLoadAndPauseIntent() }),
            ("queue_edit_revision_identity_capacity", { try suite.testQueueEditRevisionIdentityAndCapacity() }),
            ("queue_edit_pending_resolution", { try await suite.testQueueEditDuringResolutionDoesNotRestartOrAutoplay() }),
            ("queue_remove_clear_old_events", { try await suite.testQueueRemovalAndClearRejectLateDriverEvents() }),
            ("queue_clear_pending_resolution", { try await suite.testQueueClearInvalidatesPendingResolution() }),
            ("queue_shuffle_edit_history", { try suite.testShuffledQueueEditsDoNotRevisitPlayedEntries() }),
            ("queue_shuffle_refill_and_replacement", { try suite.testShuffledQueueRefillAndReplacementVisitEveryNewEntry() }),
            ("media_url_boundary", { try suite.testMediaURLBoundary() }),
            ("duplicate_terminal_failure", { try await suite.testDuplicateTerminalFailureRemainsFailed() }),
            ("ended_after_terminal_failure", { try await suite.testEndedAfterTerminalFailurePreservesQueueAndAllowsRetry() }),
            ("decoded_track_validation", { try suite.testDecodedTracksUseValidation() }),
            ("duplicate_recordings_and_entries", { try suite.testQueueAcceptsDuplicateRecordingsButNotDuplicateEntries() }),
            ("late_resolution", { try await suite.testLateResolutionCannotReplaceSelectedTrack() }),
            ("pause_during_resolution", { try await suite.testPauseWhileResolvingCannotStartPlayback() }),
            ("stop_during_resolution", { try await suite.testStopInvalidatesLateSuccess() }),
            ("native_queue_advance", { try await suite.testNativeEndAdvancesWithoutUICallback() }),
            ("repeat_modes", { try await suite.testRepeatOneAndExplicitNextDiffer() }),
            ("shuffle_order", { try suite.testShuffleVisitsEveryEntryBeforeEnding() }),
            ("bounded_network_retry", { try await suite.testNetworkRetryPreservesPositionAndStopsAfterOneRetry() }),
            ("bounded_expiry_retry", { try await suite.testExpiredSourcesRetryOnlyOnce() }),
            ("synchronous_driver_reentry", { try await suite.testSynchronousDriverReentryCannotPlaySupersededSource() }),
            ("will_play_gain_admission", { try await suite.testWillPlayHookAdmitsSystemPlayAndNativeAdvance() }),
            ("will_play_reentrant_cancellation", { try await suite.testWillPlayHookRejectsReentrantStopPauseAndReplacement() }),
            ("resolution_deadline", { try await suite.testResolutionDeadlineRejectsLateCompletion() }),
            ("startup_stall_watchdog", { try await suite.testNoErrorStartupStallRetriesOnce() }),
            ("progress_stall_watchdog", { try await suite.testRepeatedPositionCannotHideProgressStall() }),
            ("watchdog_pause_stop_cleanup", { try await suite.testPauseAndStopCancelStartupWatchdog() }),
            ("physical_resolver_admission", { try await suite.testCancelledCallerDoesNotFreePhysicalResolverSlot() }),
            ("ended_callback_watchdog_reentry", { try await suite.testEndedCallbackCannotCancelNewPlaybackWatchdog() }),
            ("device_revision_isolation", { try checkDeviceRevisionIsolation() }),
            ("http_only_boundary", { try await checkHTTPOnlyResolverBoundaries() }),
            ("partial_media_sample", { try checkPartialMediaSampleContracts() }),
            ("resolver_profile_failures", { try await checkResolverProfileFailures() })
        ]
        for (name, run) in checks {
            do { try await run(); print("PASS \(name)") }
            catch { print("FAIL \(name)"); exit(EXIT_FAILURE) }
        }
        print("Native playback deterministic checks passed: \(checks.count)")
    }
}
