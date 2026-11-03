CREATE TABLE "stored_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"body" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
