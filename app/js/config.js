/* Muster cloud accounts + sync (Supabase). Leave both empty to run local-only (no sign-in, lists stay on this device).
   The anon key is a public, browser-safe key: row-level security (supabase/schema.sql) keeps each account's lists private.
   Supabase dashboard -> Project Settings -> API: "Project URL" and the "anon" / publishable key. */
window.MUSTER_CONFIG = {
  SUPABASE_URL: "https://miaaixxxgurmyxejkynb.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pYWFpeHh4Z3VybXl4ZWpreW5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MzA0MzgsImV4cCI6MjEwNzAwNjQzOH0.fu-epwZn7U4u5Mqu7zXwsEVCXrlYD6B1fXTL8LKMv7s",
};
