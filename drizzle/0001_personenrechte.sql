CREATE TABLE "jama_benutzer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jama_user_id" integer NOT NULL,
	"username" text,
	"email" text,
	"first_name" text,
	"last_name" text,
	"license_type" text,
	"aktiv" boolean DEFAULT true NOT NULL,
	"abgeglichen_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jama_projekte" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jama_project_id" integer NOT NULL,
	"project_key" text,
	"name" text,
	"eltern_id" integer,
	"ist_ordner" boolean DEFAULT false NOT NULL,
	"archiviert" boolean DEFAULT false NOT NULL,
	"abgeglichen_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personenrechte" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jama_user_id" integer NOT NULL,
	"jama_project_id" integer NOT NULL,
	"stufe" text NOT NULL,
	"vergeben_am" timestamp with time zone DEFAULT now() NOT NULL,
	"vergeben_von" text
);
--> statement-breakpoint
CREATE TABLE "personenvorgabe" (
	"jama_user_id" integer PRIMARY KEY NOT NULL,
	"grundstufe" text DEFAULT 'lesen' NOT NULL,
	"notiz" text
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "gesperrte_projekt_ids" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "personenrechte_aktiv" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jama_benutzer_user_idx" ON "jama_benutzer" USING btree ("jama_user_id");--> statement-breakpoint
CREATE INDEX "jama_benutzer_aktiv_idx" ON "jama_benutzer" USING btree ("aktiv");--> statement-breakpoint
CREATE UNIQUE INDEX "jama_projekte_project_idx" ON "jama_projekte" USING btree ("jama_project_id");--> statement-breakpoint
CREATE INDEX "jama_projekte_eltern_idx" ON "jama_projekte" USING btree ("eltern_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personenrechte_person_projekt_idx" ON "personenrechte" USING btree ("jama_user_id","jama_project_id");--> statement-breakpoint
CREATE INDEX "personenrechte_person_idx" ON "personenrechte" USING btree ("jama_user_id");--> statement-breakpoint
CREATE INDEX "personenrechte_projekt_idx" ON "personenrechte" USING btree ("jama_project_id");