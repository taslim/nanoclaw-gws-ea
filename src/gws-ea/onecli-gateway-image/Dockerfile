# Wrapper gateway image: the pinned OneCLI base plus an in-namespace egress
# firewall applied before the gateway starts. The base ships none of the
# firewall tooling, so it is installed here: a bind-mounted rules script alone
# cannot run without iptables in the image.
#
# ONECLI_BASE comes from the `onecli-gateway` pin (src/gws-ea/versions.json).
# GATEWAY_WRAPPER_HASH is the launcher's hash of this build context and the base
# tag, stamped as a provenance label so runtime verification confirms the exact
# firewall content is running.
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
