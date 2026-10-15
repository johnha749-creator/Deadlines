// Deadline accounts. With both values empty the app keeps each list on its own device (no accounts),
// exactly as before. To turn on accounts that sync between phone and laptop, paste your Supabase
// project's URL and its publishable key (Project Settings -> API Keys; it starts with sb_publishable_).
// The publishable key is safe to put here: row level security keeps every list private to its owner.
window.DEADLINE_CONFIG = { supabaseUrl: "", supabaseKey: "", usernameDomain: "users.deadline.invalid" };
