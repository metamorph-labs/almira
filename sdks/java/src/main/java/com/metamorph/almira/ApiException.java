package com.metamorph.almira;

public final class ApiException extends ClientException {
    private final String requestId;
    private final int status;
    private final Integer retryAfterSeconds;

    ApiException(String code, String requestId, int status, Integer retryAfterSeconds) {
        super(code);
        this.requestId = requestId;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public String requestId() { return requestId; }
    public int status() { return status; }
    public Integer retryAfterSeconds() { return retryAfterSeconds; }
}
