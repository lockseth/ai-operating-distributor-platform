import * as React from "react";

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-10 w-10",
};

export function LoadingSpinner({ size = "md", className = "" }: LoadingSpinnerProps) {
  return (
    <div
      role="status"
      className={`animate-spin rounded-full border-2 border-current border-t-transparent ${sizeMap[size]} ${className}`}
      aria-label="Loading"
    />
  );
}
