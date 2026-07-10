# Tixkit CLI

Scaffold, validate, seed, and run a self-hosted Tixkit event-ticketing stack.

```sh
bunx tixkit@latest --help
# or
npx tixkit@latest --help
```

Run `tixkit init <directory> --template nextjs` from any directory to scaffold a
standalone headless integration. Inside a Tixkit OSS source checkout, use
`tixkit setup:check` and `tixkit quickstart` to validate configuration and start
the repository's Docker/application stack. `quickstart` intentionally requires
the source checkout because it uses its Compose file, migrations, and services.
