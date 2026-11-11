"use client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Account } from "@aurelia/core";

export interface NativeSignIn {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
export type NativeSignInPoll = { status: "pending" | "expired" } |
  { status: "approved"; user: Account };
interface CloudSessionBridge {
  status(): Promise<{ available: boolean; authenticated: boolean }>;
  beginSignIn(): Promise<NativeSignIn>;
  pollSignIn(): Promise<NativeSignInPoll>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<{ revoked: boolean }>;
  request(input: { path: string; method?: string; body?: string; expectedAccountId?: string }):
    Promise<{ status: number; data: unknown }>;
}
export const nativeCloudSession = registerPlugin<CloudSessionBridge>("AureliaCloudSession");
export const nativeCloudSessionAvailable = () => Capacitor.isNativePlatform() &&
  Capacitor.isPluginAvailable("AureliaCloudSession");
export const getNativeCloudSessionStatus = () => nativeCloudSession.status();
export const beginNativeSignIn = () => nativeCloudSession.beginSignIn();
export const pollNativeSignIn = () => nativeCloudSession.pollSignIn();
export const cancelNativeSignIn = () => nativeCloudSession.cancelSignIn();
export const signOutNativeSession = () => nativeCloudSession.signOut();
