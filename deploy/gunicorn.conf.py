bind = "0.0.0.0:8000"
workers = 3
timeout = 120
accesslog = "-"
# Do not log query strings, which can contain OAuth authorization codes.
access_log_format = "%(h)s %(t)s %(m)s %(U)s %(s)s %(b)s"
