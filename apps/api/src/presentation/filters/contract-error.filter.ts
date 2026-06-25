import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { CategorizedError, type ErrorCategory } from "../../domain/errors/categorized-error";

// Maps category → HTTP status per docs/api-contract.md § "Error envelope".
// If a future CategorizedError subclass forgets to register a status here,
// `catch` throws synchronously — that's a developer-time bug, not a runtime
// fallback to 500.
const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  query: 400,
  type_conversion: 422,
  connection: 502,
  schema: 502,
  capability: 404,
  // Web-only AI categories (not in docs/api-contract.md). 404 mirrors
  // `capability` (route gated off this deployment); 502 mirrors
  // `connection` (upstream third-party service failed).
  ai_disabled: 404,
  ai_provider: 502,
};

@Catch(CategorizedError)
export class ContractErrorFilter implements ExceptionFilter {
  catch(exception: CategorizedError, host: ArgumentsHost): void {
    const status = CATEGORY_STATUS[exception.category];
    if (status === undefined) {
      throw new Error(
        `unknown CategorizedError category: "${exception.category}" — register it in ContractErrorFilter.CATEGORY_STATUS`,
      );
    }
    const response = host.switchToHttp().getResponse<Response>();
    response.status(status).json({
      error: { category: exception.category, message: exception.message },
    });
  }
}
