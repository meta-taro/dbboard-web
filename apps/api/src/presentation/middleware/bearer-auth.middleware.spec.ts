import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createBearerAuthMiddleware } from "./bearer-auth.middleware";

function req(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path: "/connections",
    headers: {},
    ...overrides,
  } as Request;
}

interface FakeResponse extends Response {
  _status: number;
  _body: unknown;
}

function res(): FakeResponse {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 0,
    _body: undefined,
    status: vi.fn().mockImplementation(function (this: typeof r, code: number) {
      this._status = code;
      return this as Response;
    }),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockImplementation(function (this: typeof r, body: unknown) {
      this._body = body;
      return this as Response;
    }),
  };
  return r as FakeResponse;
}

describe("createBearerAuthMiddleware", () => {
  describe("when the secret is undefined (dev convenience)", () => {
    const guard = createBearerAuthMiddleware(undefined);

    it("calls next() for any path without checking headers", () => {
      const next = vi.fn();
      guard(req({ path: "/connections" }), res(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("calls next() for /health too", () => {
      const next = vi.fn();
      guard(req({ method: "GET", path: "/health" }), res(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("when the secret is set", () => {
    const SECRET = "test-secret-32-bytes-of-entropy!";
    const guard = createBearerAuthMiddleware(SECRET);

    it("lets GET /health through without an Authorization header (liveness exemption)", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ method: "GET", path: "/health" }), r, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(r._status).toBe(0);
    });

    it("rejects a request with no Authorization header → 401 text/plain Unauthorized", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: {} }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
      expect(r._body).toBe("Unauthorized");
    });

    it("rejects a non-Bearer scheme → 401", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: `Basic ${SECRET}` } }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });

    it("rejects the wrong token when its length matches the secret → 401", () => {
      const wrong = "x".repeat(SECRET.length);
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: `Bearer ${wrong}` } }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });

    it("rejects the wrong token when its length differs (must not throw inside timingSafeEqual) → 401", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: `Bearer short` } }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });

    it("accepts the correct Bearer token", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: `Bearer ${SECRET}` } }), r, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(r._status).toBe(0);
    });

    it("accepts a lowercase 'bearer' scheme (RFC 7235 §2.1 — case-insensitive)", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: `bearer ${SECRET}` } }), r, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects a Bearer header with no token after the scheme → 401", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ headers: { authorization: "Bearer " } }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });

    it("rejects POST /connections without auth — the SSRF-injection surface that motivated this slice", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ method: "POST", path: "/connections", headers: {} }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });

    it("rejects GET /history/export.jsonl without auth — the unauthenticated NDJSON egress", () => {
      const next = vi.fn();
      const r = res();
      guard(req({ method: "GET", path: "/history/export.jsonl", headers: {} }), r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r._status).toBe(401);
    });
  });
});
