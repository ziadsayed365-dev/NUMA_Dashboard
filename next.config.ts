import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The report PDF (src/lib/report-pdf.ts) unpacks Chromium from
  // @sparticuz/chromium's bin/ folder at run time. Nothing imports those files,
  // so the build's file tracing leaves them out and the function fails with
  // "bin does not exist" on Vercel - include them explicitly.
  outputFileTracingIncludes: {
    "/api/agent/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
