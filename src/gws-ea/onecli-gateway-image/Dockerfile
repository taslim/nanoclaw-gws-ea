# Wrapper gateway image (KTD1/KTD5): the pinned OneCLI base plus an in-namespace
# egress firewall applied before the gateway starts. The base ships none of the
# firewall tooling, so it must be installed here (a bind-mounted rules script
# alone cannot run without the iptables binary present in the image).
#
# ONECLI_BASE is fed from the existing `onecli-gateway` pin (src/gws-ea/versions.json).
# GATEWAY_WRAPPER_HASH is the build-context content hash (Dockerfile + rules.sh +
# entrypoint.sh + base tag), computed by the launcher and stamped as a provenance
# label so runtime verification confirms the exact firewall content is running (KTD6).
ARG ONECLI_BASE
FROM ${ONECLI_BASE}
ARG GATEWAY_WRAPPER_HASH
USER root
RUN apk add --no-cache iptables ip6tables iproute2 util-linux
COPY rules.sh /usr/local/bin/egress-rules.sh
COPY entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
RUN chmod 0755 /usr/local/bin/egress-rules.sh /usr/local/bin/gateway-entrypoint.sh
LABEL dev.gws-ea.onecli-wrapper="${GATEWAY_WRAPPER_HASH}"
ENTRYPOINT ["/usr/local/bin/gateway-entrypoint.sh"]
