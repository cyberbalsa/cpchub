class PrivateResponseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.user.is_authenticated or request.path.startswith(("/account/", "/accounts/", "/o/", "/api/v1/keys/")):
            response["Cache-Control"] = "private, no-store"
        response.setdefault("Referrer-Policy", "same-origin")
        return response
