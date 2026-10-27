package com.metamorph.almira;

public class ClientException extends RuntimeException {
    private final String code;

    public ClientException(String code) {
        super(code);
        this.code = code;
    }

    public String code() { return code; }

    static ClientException input() { return new ClientException("ALMIRA_CLIENT_INPUT_INVALID"); }
    static ClientException response() { return new ClientException("ALMIRA_CLIENT_RESPONSE_INVALID"); }
    static ClientException network() { return new ClientException("ALMIRA_CLIENT_NETWORK"); }
    static ClientException credential() { return new ClientException("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"); }
}
