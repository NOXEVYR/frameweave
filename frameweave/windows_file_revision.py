"""Read one file's NTFS change-journal revision without opening a volume."""
import ctypes
from ctypes import wintypes
import msvcrt
import struct


_read_file_usn_data = 0x000900EB  # FSCTL_READ_FILE_USN_DATA from winioctl.h
_kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
_device_io_control = _kernel32.DeviceIoControl
_device_io_control.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
    wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
]
_device_io_control.restype = wintypes.BOOL
_reopen_file = _kernel32.ReOpenFile
_reopen_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
_reopen_file.restype = wintypes.HANDLE
_close_handle = _kernel32.CloseHandle
_close_handle.argtypes = [wintypes.HANDLE]
_close_handle.restype = wintypes.BOOL
_invalid_handle = ctypes.c_void_p(-1).value
_generic_read = 0x80000000
_share_read_delete = 0x1 | 0x4


def file_revision(descriptor):
    """Return a V2 file USN, or None when this file cannot supply one."""
    # NTFS can coalesce repeated writes by a still-open writer into one USN.
    # A sharing violation disables caching for this lookup. Release the probe
    # immediately, before parsing or reading any contents.
    probe = _reopen_file(msvcrt.get_osfhandle(descriptor), _generic_read, _share_read_delete, 0)
    if probe == _invalid_handle:
        return None
    try:
        buffer = ctypes.create_string_buffer(1024)
        count = wintypes.DWORD()
        ok = _device_io_control(probe, _read_file_usn_data,
                                None, 0, buffer, len(buffer), ctypes.byref(count), None)
    finally:
        _close_handle(probe)
    if not ok or count.value < 60:
        return None
    length, version = struct.unpack_from('<IH', buffer)
    if version != 2 or not 60 <= length <= count.value:
        return None
    revision, = struct.unpack_from('<q', buffer, 24)
    return revision if revision > 0 else None
