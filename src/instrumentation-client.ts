import { initBotId } from "botid/client/core";

// Basic is free; explicitly match the server to prevent an account setting from
// silently selecting paid Deep Analysis. Human judging has no usage quota.
// The SDK's server check deliberately allows local development. Challenge routes
// are supplied by Vercel in deployed production/preview environments.
if (process.env.NODE_ENV === "production") initBotId({
  protect: [
    { path: "/api/search", method: "GET", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/tags", method: "GET", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/preset", method: "GET", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/sample", method: "GET", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/runs/*", method: "GET", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/runs/*", method: "DELETE", advancedOptions: { checkLevel: "basic" } },
    { path: "/api/*", method: "POST", advancedOptions: { checkLevel: "basic" } },
  ],
});
