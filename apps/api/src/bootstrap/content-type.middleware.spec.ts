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

  // ---- the restore exemption (0030 slice E) --------------------------
  //
  // Restore is the one surface that takes a body which is not JSON: a
  // `.sql` script, posted as-is. The exemption is scoped to those two
  // paths so no other route quietly gains a second accepted media type.

  it("passes POST application/sql on the restore route", () => {
    const next = vi.fn();
    contentTypeGuard(
      req({ path: "/connections/c1/restore", headers: { "content-type": "application/sql" } }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes POST application/sql on the restore-plan route", () => {
    const next = vi.fn();
    contentTypeGuard(
      req({ path: "/connections/c1/restore/plan", headers: { "content-type": "application/sql" } }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passes POST application/sql with a charset parameter", () => {
    const next = vi.fn();
    contentTypeGuard(
      req({
        path: "/connections/c1/restore",
        headers: { "content-type": "application/sql; charset=utf-8" },
      }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("still passes POST application/json on the restore route", () => {
    // The exemption widens what restore accepts; it does not narrow it.
    const next = vi.fn();
    contentTypeGuard(
      req({ path: "/connections/c1/restore", headers: { "content-type": "application/json" } }),
      res(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects POST application/sql on any other route → 415", () => {
    const next = vi.fn();
    const r = res();
    contentTypeGuard(
      req({ path: "/connections/c1/query", headers: { "content-type": "application/sql" } }),
      r,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(r._status).toBe(415);
  });

  it("rejects POST application/sql on a path that merely contains 'restore' → 415", () => {
    const next = vi.fn();
    const r = res();
    contentTypeGuard(
      req({ path: "/connections/c1/restore/all", headers: { "content-type": "application/sql" } }),
      r,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(r._status).toBe(415);
  });

  it("rejects POST text/plain on the restore route → 415", () => {
    // A `.sql` script is not "any non-JSON body will do".
    const next = vi.fn();
    const r = res();
    contentTypeGuard(
      req({ path: "/connections/c1/restore", headers: { "content-type": "text/plain" } }),
      r,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(r._status).toBe(415);
  });
});
