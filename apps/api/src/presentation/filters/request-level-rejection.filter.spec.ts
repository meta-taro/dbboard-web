import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
  type ArgumentsHost,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RequestLevelRejectionFilter } from "./request-level-rejection.filter";

interface MockedResponse {
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function mockHost(): { host: ArgumentsHost; res: MockedResponse } {
  const send = vi.fn();
  const json = vi.fn();
  const type = vi.fn().mockReturnValue({ send });
  const status = vi.fn().mockReturnValue({ type, json, send });
  const res = { status, type, json, send };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe("RequestLevelRejectionFilter", () => {
  const filter = new RequestLevelRejectionFilter();

  it("converts body-parser PayloadTooLargeError to plain-text 413", () => {
    const { host, res } = mockHost();
    const oversize = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
      statusCode: 413,
    });
    filter.catch(oversize, host);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    const sendFn = res.type.mock.results[0]?.value.send as ReturnType<typeof vi.fn>;
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining("64 KiB"));
  });

  it("converts HttpException(400) to plain-text 400", () => {
    const { host, res } = mockHost();
    filter.catch(new BadRequestException("Unexpected token in JSON"), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith("text/plain");
  });

  it("preserves JSON envelope for HttpException(422)", () => {
    const { host, res } = mockHost();
    filter.catch(
      new UnprocessableEntityException({
        statusCode: 422,
        message: ["sql should not be empty"],
        error: "Unprocessable Entity",
      }),
      host,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, error: "Unprocessable Entity" }),
    );
  });

  it("preserves JSON envelope for HttpException(404) unknown route", () => {
    const { host, res } = mockHost();
    filter.catch(new NotFoundException("Cannot POST /missing"), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalled();
  });

  it("preserves JSON envelope for string-body HttpException", () => {
    const { host, res } = mockHost();
    // Some HttpException constructors store the response as a bare string.
    // Reproduce by hand-crafting one.
    filter.catch(new HttpException("teapot", HttpStatus.I_AM_A_TEAPOT), host);
    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith({ statusCode: 418, message: "teapot" });
  });

  it("emits a generic 500 envelope for uncaught non-HttpException errors", () => {
    const { host, res } = mockHost();
    filter.catch(new Error("boom"), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ statusCode: 500, message: "Internal Server Error" });
  });
});
