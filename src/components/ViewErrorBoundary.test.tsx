import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewErrorBoundary } from "./ViewErrorBoundary";

function Boom() {
  throw new Error("test boom");
}

describe("ViewErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <ViewErrorBoundary label="Test">
        <p>ok</p>
      </ViewErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("shows recovery UI on child error", () => {
    render(
      <ViewErrorBoundary label="Studio">
        <Boom />
      </ViewErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Studio");
    expect(screen.getByText("test boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Riprova" })).toBeInTheDocument();
  });
});
