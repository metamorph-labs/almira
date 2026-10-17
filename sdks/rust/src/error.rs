use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientError {
    pub code: &'static str,
}

impl Display for ClientError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ClientError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApiError {
    pub code: String,
    pub request_id: String,
    pub status: u16,
    pub retry_after_seconds: Option<u32>,
}

impl Display for ApiError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for ApiError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Client(ClientError),
    Api(ApiError),
}

impl Display for Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Client(error) => Display::fmt(error, formatter),
            Self::Api(error) => Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for Error {}

pub(crate) fn client_error(code: &'static str) -> Error {
    Error::Client(ClientError { code })
}

pub(crate) fn invalid_input() -> Error {
    client_error("ALMIRA_CLIENT_INPUT_INVALID")
}

pub(crate) fn invalid_response() -> Error {
    client_error("ALMIRA_CLIENT_RESPONSE_INVALID")
}
