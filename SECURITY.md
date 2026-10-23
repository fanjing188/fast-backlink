# Security and privacy

Do not post access tokens, API keys, configuration, product archives, source inventories or unredacted logs in public issues. The local connection URL contains a bearer token. Stop the service before investigating an unexpected write; preserve evidence and do not repeat a submission with an unknown result.

The extension talks to a token-protected loopback service. Do not reverse-proxy it to the public internet or share its URL. The service is a single-user local application, not a multi-tenant security boundary. Browser permissions and optional AI data flow are documented in [capabilities](docs/CAPABILITIES.md) and [listing draft](docs/STORE_LISTING.md).

Installation is user-scoped. Scripts do not request sudo, change browser policy, edit shell profiles or register an OS daemon. Updates preserve user data and refuse to run while the managed foreground service holds its lock. Uninstall removes owned code, not your assets; remove the browser extension separately.

AI is off by default. When enabled, the configured provider receives permitted form metadata and candidate-key information; optional text previews must be reviewed before use. Exported asset bundles contain private business material even though the source code may later be open source.

A private vulnerability-reporting channel has not yet been published. Until it exists, do not disclose credentials or exploitable details in a public issue; contact the project owner through an existing private channel. MIT permissions are recorded in LICENSE and NOTICE; public publication still requires final verification and approval.
