import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";

vi.mock("../i18n/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    sortLocale: "en",
    setLocale: vi.fn(),
  }),
}));

describe("LoadingState", () => {
  it("renders loading status", () => {
    render(<LoadingState />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("state.loading")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("renders retry button", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="fail" onRetry={onRetry} />);
    screen.getByRole("button").click();
    expect(onRetry).toHaveBeenCalled();
  });
});
