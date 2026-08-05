import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiUpstreamError } from "../../domain/ai/ai-error";
import {
  CapabilityError,
  ConflictError,
  ConnectionError,
  QueryError,
  SchemaError,
  TypeConversionError,
} from "../../domain/errors";
import { CategorizedError } from "../../domain/errors/categorized-error";
import { ContractErrorFilter } from "./contract-error.filter";

function host(): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status };
  const switchToHttp = vi.fn().mockReturnValue({ getResponse: () => response });
  return {
    host: { switchToHttp } as unknown as ArgumentsHost,
    status,
    json,
  };
}

describe("ContractErrorFilter", () => {
  it.each([
    [new QueryError("bad"), 400, "query"],
    [new TypeConversionError("bad"), 422, "type_conversion"],
    [new ConnectionError("bad"), 502, "connection"],
    [new SchemaError("bad"), 502, "schema"],
    [new CapabilityError("bad"), 404, "capability"],
    [new ConflictError("bad"), 409, "conflict"],
    [new AiDisabledError("bad"), 404, "ai_disabled"],
    [new AiUpstreamError("bad"), 502, "ai_provider"],
  ])("maps %s to the contract envelope", (err, code, category) => {
    const { host: h, status, json } = host();
    new ContractErrorFilter().catch(err, h);
    expect(status).toHaveBeenCalledWith(code);
    expect(json).toHaveBeenCalledWith({ error: { category, message: "bad" } });
  });

  it("refuses to map a CategorizedError with an unknown category — surface the bug, do not silently 500", () => {
    class WeirdError extends CategorizedError {
      readonly category = "weird" as never;
    }
    const filter = new ContractErrorFilter();
    expect(() => filter.catch(new WeirdError("?"), host().host)).toThrowError(
      /unknown CategorizedError category/i,
    );
  });
});
