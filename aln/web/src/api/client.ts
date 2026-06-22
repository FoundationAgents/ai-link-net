/* Axios client with auth interceptors. */

import axios from "axios";
import type { StandardResponse } from "@/types";

const DEFAULT_API_BASE = "http://localhost:7001/api/v1";

/** Get current API base URL from localStorage user profile or fallback to default. */
function getApiBaseUrl(): string {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");
  }

  const raw = localStorage.getItem("fp_current_user");
  if (raw) {
    try {
      const user = JSON.parse(raw) as { host_url?: string };
      if (user.host_url) {
        return `${user.host_url.replace(/\/$/, "")}/api/v1`;
      }
    } catch {
      /* ignore */
    }
  }
  return import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE;
}

export const apiClient = axios.create({
  timeout: 10_000,
  headers: { "Content-Type": "application/json" },
});

// Dynamically set baseURL on each request
apiClient.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();

  const raw = localStorage.getItem("fp_current_user");
  if (raw) {
    try {
      const user = JSON.parse(raw) as { entity_uid?: string };
      if (user.entity_uid) {
        config.headers["X-Entity-UID"] = user.entity_uid;
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  (err) => {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      localStorage.removeItem("fp_current_user");
      window.location.href = "/";
    }
    return Promise.reject(err);
  },
);

/** Build full API URL from relative path. */
export function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

/** Extract a readable message from API or network errors. */
export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (typeof data === "object" && data !== null) {
      if ("message" in data && typeof data.message === "string" && data.message) {
        return data.message;
      }
      if ("detail" in data) {
        const detail = data.detail;
        if (typeof detail === "string" && detail) {
          return detail;
        }
        if (Array.isArray(detail)) {
          return detail
            .map((item) =>
              typeof item === "object" && item && "msg" in item
                ? String(item.msg)
                : String(item),
            )
            .join("; ");
        }
      }
    }
    if (error.response?.status === 404) {
      return "Group room API is unavailable. Restart the ALN backend from codex/group-collaboration-rooms.";
    }
    if (typeof error.message === "string" && error.message) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Request failed";
}

/** Safely unwrap StandardResponse — throws if data is absent. */
export function unwrap<T>(response: StandardResponse<T>): T {
  if (response.success === false) {
    throw new Error(response.message || "Request failed");
  }
  if (response.data === undefined) {
    throw new Error(response.message || "Unexpected empty response");
  }
  return response.data;
}

/** Derive WebSocket base from current API base. */
export function wsBaseUrl(): string {
  const apiBase = getApiBaseUrl();
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/api\/v1\/?$/, "/");
}
