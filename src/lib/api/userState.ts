import type { UserStatePatch, UserStateV1 } from "../../types"
import {
  apiFetch,
  apiUrl,
  ensureSelectedAccountId,
  isBackendUnreachableError,
  markApiUnreachable,
  unwrap,
  unwrapUserStateMutation,
} from "./core"

let inflightUserStateFetch: Promise<UserStateV1> | null = null

export async function fetchUserState(): Promise<UserStateV1> {
  if (inflightUserStateFetch) return inflightUserStateFetch
  inflightUserStateFetch = (async () => {
    try {
      await ensureSelectedAccountId()
      const response = await apiFetch("/api/user-state")
      return await unwrap<UserStateV1>(response)
    } catch (err: unknown) {
      if (isBackendUnreachableError(err)) markApiUnreachable()
      throw err
    } finally {
      inflightUserStateFetch = null
    }
  })()
  return inflightUserStateFetch
}

export async function fetchUserStateForAccount(
  accountId: string,
): Promise<UserStateV1> {
  const id = String(accountId || "").trim()
  if (!id) throw new Error("missing accountId")
  const response = await apiFetch(
    "/api/user-state",
    { cache: "no-store" },
    { accountId: id },
  )
  return unwrap<UserStateV1>(response)
}

export type CustomThemeBgUploadResult = {
  bgImage: string
  bgImageRev: number
}

export function customThemeBgImageUrl(rev?: number): string {
  const params: Record<string, string> = {}
  if (rev != null && Number.isFinite(rev)) params.v = String(Math.floor(rev))
  return apiUrl("/api/user-state/custom-theme-bg", params)
}

export async function uploadCustomThemeBg(
  file: File,
): Promise<CustomThemeBgUploadResult> {
  await ensureSelectedAccountId()
  const fd = new FormData()
  fd.append("file", file)
  const response = await apiFetch("/api/user-state/custom-theme-bg", {
    method: "POST",
    body: fd,
  })
  return unwrap<CustomThemeBgUploadResult>(response)
}

export async function clearCustomThemeBg(): Promise<void> {
  await ensureSelectedAccountId()
  const response = await apiFetch("/api/user-state/custom-theme-bg", {
    method: "DELETE",
  })
  await unwrap<null>(response)
}

export async function patchUserState(
  patch: UserStatePatch,
  opts?: { accountId?: string | null },
): Promise<UserStateV1> {
  await ensureSelectedAccountId()
  // Header esplicito quando noto: al cambio account il flush su pagehide
  // parte quando localStorage contiene già il NUOVO id — senza pin, le
  // patch pendenti dell'account precedente verrebbero scritte su quello nuovo.
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts?.accountId) headers["X-KORD-Account-Id"] = opts.accountId
  const response = await apiFetch("/api/user-state", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: patch }),
  })
  return unwrapUserStateMutation(response)
}
