// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { takePhonePairingRequest } from "@/lib/phone-pairing";
import type { CompanionAccountState } from "../types/ogb";
import type { CompanionState } from "./PhoneSetupFlow";

const policy = vi.hoisted(() => ({ remoteAccess: true }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: { managedPolicy: { remoteAccess: policy.remoteAccess, organizationName: "Fixture" } } } }),
  api: vi.fn(async () => ({ phones: [] })),
}));
const { PhoneDevicesSection } = await import("./PhoneDevicesSection");

const HOSTED = "https://c-opaque.openmausbot.com";
const TAILNET = "ada-mac.tail1234.ts.net";
const DESCRIPTOR = { v: 1, k: "a".repeat(87), h: "b".repeat(22), r: ["relay1.openmausbot.com"] } satisfies NonNullable<NonNullable<CompanionState["e2e"]>["descriptor"]>;
const off = { on: false, since: null };

function desktop({ wifi = true, encrypted = false } = {}) {
  let companion: CompanionState = {
    enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null,
    lan: wifi ? "192.168.1.34" : null,
    tailnetName: TAILNET,
    routes: {
      wifi: { on: wifi, since: null }, relay: { on: encrypted, since: null },
      tailscale: { on: true, since: 1, name: TAILNET }, https: off,
    },
    endpoints: [
      ...(wifi ? [{ kind: "lan" as const, url: "http://192.168.1.34:8810", priority: 0 }] : []),
      { kind: "tailnet", url: `http://${TAILNET}:8810`, priority: 100 },
    ],
    ...(encrypted ? { e2e: { enabled: true, relay: "connected", node: "relay1.openmausbot.com", descriptor: DESCRIPTOR } } : {}),
  };
  let account: CompanionAccountState = { available: true, status: "ready", email: "ada@example.com" };
  const prepared = Promise.withResolvers<CompanionAccountState>();
  const snapshot = async () => structuredClone(companion);
  const bridge = {
    companion: {
      state: vi.fn(snapshot),
      start: vi.fn(async () => { companion.enabled = true; return snapshot(); }),
      refreshTailscale: vi.fn(snapshot),
      pairing: vi.fn(async (open: boolean) => {
        companion = {
          ...companion,
          pairing: open ? { code: "123456", token: `omb_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 } : null,
        };
        return snapshot();
      }),
    },
    companionAccount: {
      state: vi.fn(async () => structuredClone(account)),
      prepare: vi.fn(() => prepared.promise.then((next) => structuredClone(next))),
    },
  };
  return {
    bridge,
    finishPrepare() {
      companion = { ...companion, endpoints: [...(companion.endpoints ?? []), { kind: "hosted", url: HOSTED, priority: 0 }] };
      account = { ...account, endpoint: HOSTED };
      prepared.resolve(structuredClone(account));
    },
  };
}

let host: HTMLDivElement;
let root: Root;
const dialog = () => document.querySelector<HTMLElement>("[data-pair-dialog]");
const qr = () => dialog()?.querySelector('[aria-label="Device pairing QR code"]');
const button = (label: string) => [...(dialog() ?? host).querySelectorAll("button")]
  .find((candidate) => candidate.textContent?.trim() === label);

beforeEach(() => {
  setLocale("en");
  policy.remoteAccess = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(globalThis, "ogb");
  vi.useRealTimers();
});

async function open(fake: ReturnType<typeof desktop>, secure = false) {
  Reflect.set(globalThis, "ogb", fake.bridge);
  flushSync(() => root.render(createElement(PhoneDevicesSection)));
  const selector = secure ? '[data-route-row="https"] button' : "[data-pair-device]";
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(false));
  flushSync(() => host.querySelector<HTMLButtonElement>(selector)!.click());
}

it("Pair a phone opens a Wi-Fi QR with encrypted relay metadata without preparing HTTPS", async () => {
  const fake = desktop({ encrypted: true });
  await open(fake);
  await vi.waitFor(() => expect(qr()).toBeTruthy());
  expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
  flushSync(() => button("Copy link")!.click());
  await vi.waitFor(async () => expect(await navigator.clipboard.readText()).toContain("openmausbot://pair"));
  const link = new URL(await navigator.clipboard.readText());
  const encoded = link.searchParams.get("e2e");
  expect(encoded).not.toBeNull();
  expect(JSON.parse(atob(encoded!.replaceAll("-", "+").replaceAll("_", "/")))).toEqual(DESCRIPTOR);
});

it("Pair a phone opens a tailnet QR when Tailscale is the only enabled route and there is no LAN address", async () => {
  const fake = desktop({ wifi: false });
  await open(fake);
  await vi.waitFor(() => expect(qr()).toBeTruthy());
  expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
  flushSync(() => button("Reveal")!.click());
  expect(dialog()?.textContent).toContain(`${TAILNET}:8810`);
});

it("HTTPS Set up prepares once while pending and settles on the hosted QR without restarting pairing", async () => {
  const fake = desktop();
  await open(fake, true);
  await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
  expect(dialog()?.textContent).toContain("Creating secure remote access");
  expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
  fake.finishPrepare();
  await vi.waitFor(() => expect(qr()).toBeTruthy());
  flushSync(() => button("Reveal")!.click());
  expect(dialog()?.textContent).toContain(HOSTED);
  expect(fake.bridge.companion.pairing).toHaveBeenCalledExactlyOnceWith(true);
  expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledTimes(2);
});

it("HTTPS Set up times out after 30 seconds even when every poll returns a fresh snapshot", async () => {
  vi.useFakeTimers();
  const fake = desktop();
  await open(fake, true);
  await vi.waitFor(() => expect(fake.bridge.companionAccount.prepare).toHaveBeenCalledOnce());
  for (let second = 0; second < 31; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    flushSync(() => {});
  }
  expect(fake.bridge.companion.state.mock.calls.length).toBeGreaterThan(10);
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Secure access is taking longer than expected. You can try again or pair directly on this Wi-Fi.",
  );
  expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
});


it("opens a requested pairing only after the initial companion snapshot loads", async () => {
  const fake = desktop();
  Reflect.set(globalThis, "ogb", fake.bridge);
  takePhonePairingRequest("http://localhost/?desktop-settings=phone&pair=open", true);
  flushSync(() => root.render(createElement(PhoneDevicesSection, { focusRequest: 1 })));
  await vi.waitFor(() => expect(qr()).toBeTruthy());
  expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
});

it("does not start requested pairing when organization policy blocks remote access", async () => {
  policy.remoteAccess = false;
  const fake = desktop();
  Reflect.set(globalThis, "ogb", fake.bridge);
  takePhonePairingRequest("http://localhost/?desktop-settings=phone&pair=open", true);
  flushSync(() => root.render(createElement(PhoneDevicesSection, { focusRequest: 1 })));
  await vi.waitFor(() => expect(host.querySelector("[data-pair-device]")).not.toBeNull());
  expect(dialog()).toBeNull();
  expect(fake.bridge.companion.pairing).not.toHaveBeenCalled();
  expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
});
