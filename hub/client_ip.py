from ipaddress import ip_address, ip_network

from django.conf import settings


def normalize_ip(value):
    try:
        if not value or "%" in value:
            return None
        address = ip_address(value.strip())
    except ValueError:
        return None
    return str(getattr(address, "ipv4_mapped", None) or address)


class TrustedProxyMiddleware:
    """Accept the proxy's single, replaced X-Real-IP only from configured peers."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.networks = [ip_network(value) for value in settings.TRUSTED_PROXY_CIDRS] if settings.TRUST_PROXY else []

    def __call__(self, request):
        peer = normalize_ip(request.META.get("REMOTE_ADDR", ""))
        trusted = bool(peer and any(ip_address(peer) in network for network in self.networks))
        client = normalize_ip(request.META.get("HTTP_X_REAL_IP", "")) if trusted else peer
        request.client_ip = client
        request.client_ip_source = ("proxy" if trusted else "direct") if client else "unknown"
        request.trusted_proxy = trusted
        # Allauth, DRF throttles, and Gunicorn logs use the same normalized address.
        request.META["REMOTE_ADDR"] = client or peer or ""
        for header in ["HTTP_X_FORWARDED_FOR", "HTTP_X_REAL_IP"]:
            request.META.pop(header, None)
        if not trusted:
            request.META.pop("HTTP_X_FORWARDED_PROTO", None)
        return self.get_response(request)
