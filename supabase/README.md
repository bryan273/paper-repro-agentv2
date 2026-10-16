# Supabase: shared store for "run it on your own agent"

`schema.sql` creates three tables (jobs, one-time tokens, events), two functions the public key may call
(`create_job`, `post_event`) and a public `kits` bucket for the plain-text kit files.
Apply it with the SQL editor, or with any Postgres client using the project's database password.

- The viewer holds only the project URL and the publishable key (both public).
- A job's token is returned once by `create_job` and lives inside that job's kit; it cannot read or write any other job.
- No model key lives here. The agent that follows a kit uses its owner's own model and machine.
