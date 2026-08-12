CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"account_type" text DEFAULT 'user' NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jama_credentials_enc" text,
	"toolsets" text[] NOT NULL,
	"allowed_project_ids" integer[] DEFAULT '{}' NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"rate_limit_rps" real,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT 'admin' NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_key" text,
	"payload" jsonb,
	"result" text NOT NULL,
	"message" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "jama_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_type" text NOT NULL,
	"credentials_enc" text NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"api_version" text,
	"capabilities" jsonb,
	"rate_limit_rps" real,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_message" text,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ip" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "usage_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"api_key_id" uuid,
	"api_key_name" text,
	"tool_name" text NOT NULL,
	"toolset" text,
	"project_id" integer,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"jama_call_count" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"response_bytes" integer DEFAULT 0 NOT NULL,
	"est_tokens" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_connection_id_jama_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jama_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_idx" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_connection_idx" ON "api_keys" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_action_ts_idx" ON "audit_log" USING btree ("action","ts");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_key");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_ts_idx" ON "login_attempts" USING btree ("ip","ts");--> statement-breakpoint
CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "usage_events_key_ts_idx" ON "usage_events" USING btree ("api_key_id","ts");--> statement-breakpoint
CREATE INDEX "usage_events_tool_ts_idx" ON "usage_events" USING btree ("tool_name","ts");