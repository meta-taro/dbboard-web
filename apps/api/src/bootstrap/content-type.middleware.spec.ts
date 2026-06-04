import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { contentTypeGuard } from "./content-type.middleware";

function req(overrides: Partial<Request>): Request {
  return { method: "POST", headers: {}, ...overrides } as Request;
}
function res(): Response & { _status: number; _body: unknown } {
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
  return r as Response & { _status: number; _body: unknown };
}

describe("contentTypeGuard", () => {
  it("passes GET requests through (no body, no Content-Type concern)", () => {
    const next = vi.fn();
    contentTypeGuard(req({ method: "GET" }), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes DELETE requests through (no body in our contract)", () => {
    const next = vi.fn();
    contentTypeGuard(req({ method: "DELETE" }), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes POST with application/json", () => {
    const next = vi.fn();
    contentTypeGuard(req({ headers: { "content-type": "application/json" } }), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes POST with application/json; charset=utf-8", () => {
    const next = vi.fn();
    contentTypeGuard(
      req({ headers: { "content-type": "application/json; charset=utf-8" } }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects POST with text/plain → 415", () => {
    const next = vi.fn();
    const r = res();
    contentTypeGuard(req({ headers: { "content-type": "text/plain" } }), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r._status).toBe(415);
  });

  it("rejects POST without Content-Type → 415", () => {
    const next = vi.fn();
    const r = res();
    contentTypeGuard(req({ headers: {} }), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r._status).toBe(415);
  });
});
