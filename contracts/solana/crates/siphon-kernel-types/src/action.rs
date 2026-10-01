/// PROTOCOL spend actions (public limb / circuit family selector).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SpendAction {
    Withdraw = 0,
    Merge = 1,
    Swap = 2,
    Split = 3,
    Ragequit = 4,
}

impl SpendAction {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Withdraw),
            1 => Some(Self::Merge),
            2 => Some(Self::Swap),
            3 => Some(Self::Split),
            4 => Some(Self::Ragequit),
            _ => None,
        }
    }

    pub const fn as_u8(self) -> u8 {
        self as u8
    }
}
