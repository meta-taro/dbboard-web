// Honour ?lang=<bcp47> as the highest-priority locale override. Mirrors the
// "DBBOARD_LANG > OS > en" precedence on desktop (ADR-0015 §Resolution): the
// query param is the operator override; cookie is the persistent user choice;
// Accept-Language is the implicit default.
//
// Runs on every navigation. setLocale() also writes the dbboard_lang cookie,
// so a future navigation without ?lang= still resolves to the chosen locale.

import { isSupportedLocale } from "../../i18n/config";

export default defineNuxtRouteMiddleware(async (to) => {
  const raw = to.query.lang;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!isSupportedLocale(candidate)) {
    return;
  }
  const { setLocale, locale } = useI18n();
  if (locale.value === candidate) {
    return;
  }
  await setLocale(candidate);
});
