CREATE TABLE IF NOT EXISTS `environment_path_canonicalizations` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
