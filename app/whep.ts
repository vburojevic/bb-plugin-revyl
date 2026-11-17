/**
 * A minimal WHEP (WebRTC-HTTP Egress Protocol) player for Revyl's device
 * stream. Revyl serves it from Cloudflare Realtime: POST an SDP offer, get an
 * SDP answer, receive one video track. The URL is the only credential, so it
 * is never logged or rendered.
 */

import { useEffect, useRef, useState } from "react";

export type StreamState = "idle" | "connecting" | "live" | "failed" | "ended";

const ICE_GATHER_TIMEOUT_MS = 2_000;

async function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export function useWhepStream(url: string | null, video: React.RefObject<HTMLVideoElement | null>, attempt: number) {
  const [state, setState] = useState<StreamState>("idle");
  const resource = useRef<string | null>(null);

  useEffect(() => {
    if (url === null) {
      setState("idle");
      return;
    }
    let cancelled = false;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      const element = video.current;
      if (element === null) return;
      element.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void element.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (cancelled) return;
      if (pc.connectionState === "connected") setState("live");
      else if (pc.connectionState === "failed") setState("failed");
      else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") setState("ended");
    };
    setState("connecting");
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription?.sdp ?? offer.sdp ?? "",
      });
      if (!response.ok) throw new Error(`stream answered ${response.status}`);
      const location = response.headers.get("location");
      resource.current = location === null ? null : new URL(location, url).toString();
      const answer = await response.text();
      if (cancelled) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    })().catch(() => {
      if (!cancelled) setState("failed");
    });
    return () => {
      cancelled = true;
      const teardown = resource.current;
      resource.current = null;
      pc.close();
      if (video.current !== null) video.current.srcObject = null;
      if (teardown !== null) void fetch(teardown, { method: "DELETE" }).catch(() => undefined);
    };
  }, [url, video, attempt]);

  return state;
}
