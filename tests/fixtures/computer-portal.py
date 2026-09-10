import base64
import importlib.util
import os
import threading
import unittest
from pathlib import Path

import dbus
import dbus.service
import gi
from dbus.lowlevel import HANDLER_RESULT_NOT_YET_HANDLED, MESSAGE_TYPE_METHOD_CALL
from dbus.mainloop.glib import DBusGMainLoop

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GLib, Gst, GdkPixbuf

Gst.init(None)
DBusGMainLoop(set_as_default=True)
spec = importlib.util.spec_from_file_location("computer", Path(__file__).parents[2] / "desktop/computer-linux.py")
computer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(computer)
REMOTE = "org.freedesktop.portal.RemoteDesktop"
CAST = "org.freedesktop.portal.ScreenCast"


class Request(dbus.service.Object):
    @dbus.service.signal("org.freedesktop.portal.Request", signature="ua{sv}")
    def Response(self, code, result):
        pass

    @dbus.service.method("org.freedesktop.portal.Request", in_signature="", out_signature="")
    def Close(self):
        self.remove_from_connection()


class Session(dbus.service.Object):
    closed = False

    @dbus.service.method("org.freedesktop.portal.Session", in_signature="", out_signature="")
    def Close(self):
        self.closed = True


class ScreenCast(dbus.service.Object):
    @dbus.service.method(CAST, in_signature="a{sv}", out_signature="o", sender_keyword="sender")
    def CreateSession(self, options, sender=None):
        return self.create(options, sender)

    @dbus.service.method(CAST, in_signature="osa{sv}", out_signature="o", sender_keyword="sender")
    def Start(self, session, parent, options, sender=None):
        return self.start(session, parent, options, sender)


class Desktop(ScreenCast):
    def __init__(self, bus):
        super().__init__(bus, "/org/freedesktop/portal/desktop")
        self.bus = bus
        self.calls = []
        self.signatures = []
        self.requests = []
        self.sessions = []
        self.deny = False
        bus.add_message_filter(self.record_signature)

    def record_signature(self, connection, message):
        if message.get_type() == MESSAGE_TYPE_METHOD_CALL and message.get_interface() in (REMOTE, CAST):
            self.signatures.append((message.get_interface(), message.get_member(), str(message.get_signature())))
        return HANDLER_RESULT_NOT_YET_HANDLED

    def request(self, sender, options, result):
        path = "/org/freedesktop/portal/desktop/request/" + sender[1:].replace(".", "_") + "/" + options["handle_token"]
        request = Request(self.bus, path)
        self.requests.append(request)
        def respond():
            request.Response(1 if self.deny else 0, result)
            return False
        GLib.timeout_add(10, respond)
        return dbus.ObjectPath(path)

    @dbus.service.method(REMOTE, in_signature="a{sv}", out_signature="o", sender_keyword="sender")
    def CreateSession(self, options, sender=None):
        return self.create(options, sender)

    def create(self, options, sender):
        path = "/org/freedesktop/portal/desktop/session/fixture/" + options["session_handle_token"]
        self.sessions.append(Session(self.bus, path))
        self.calls.append(("create", dict(options)))
        return self.request(sender, options, {"session_handle": dbus.String(path)})

    @dbus.service.method(REMOTE, in_signature="oa{sv}", out_signature="o", sender_keyword="sender")
    def SelectDevices(self, session, options, sender=None):
        self.calls.append(("devices", dict(options)))
        return self.request(sender, options, {})

    @dbus.service.method(CAST, in_signature="oa{sv}", out_signature="o", sender_keyword="sender")
    def SelectSources(self, session, options, sender=None):
        self.calls.append(("sources", dict(options)))
        return self.request(sender, options, {})

    @dbus.service.method(REMOTE, in_signature="osa{sv}", out_signature="o", sender_keyword="sender")
    def Start(self, session, parent, options, sender=None):
        return self.start(session, parent, options, sender)

    def start(self, session, parent, options, sender):
        streams = dbus.Array([dbus.Struct((dbus.UInt32(42), dbus.Dictionary({"size": dbus.Struct((800, 600), signature="ii"), "logical_size": dbus.Struct((400, 300), signature="ii")}, signature="sv")), signature="ua{sv}")], signature="(ua{sv})")
        return self.request(sender, options, {"devices": dbus.UInt32(3), "streams": streams})

    @dbus.service.method(CAST, in_signature="oa{sv}", out_signature="h")
    def OpenPipeWireRemote(self, session, options):
        fd = os.memfd_create("portal-test")
        value = dbus.types.UnixFd(fd)
        os.close(fd)
        return value

    @dbus.service.method(REMOTE, in_signature="oa{sv}udd", out_signature="")
    def NotifyPointerMotionAbsolute(self, session, options, stream, x, y):
        self.calls.append(("move", int(stream), float(x), float(y)))

    @dbus.service.method(REMOTE, in_signature="oa{sv}iu", out_signature="")
    def NotifyPointerButton(self, session, options, button, state):
        self.calls.append(("button", int(button), int(state)))

    @dbus.service.method(REMOTE, in_signature="oa{sv}iu", out_signature="")
    def NotifyKeyboardKeysym(self, session, options, key, state):
        self.calls.append(("key", int(key), int(state)))

    @dbus.service.method(REMOTE, in_signature="oa{sv}dd", out_signature="")
    def NotifyPointerAxis(self, session, options, dx, dy):
        self.calls.append(("scroll", float(dx), float(dy), bool(options["finish"])))


class Source:
    def set_property(self, name, value):
        pass


class Pipeline:
    def __init__(self):
        self.pipeline = Gst.parse_launch("videotestsrc is-live=true pattern=red ! video/x-raw,width=800,height=600,framerate=5/1 ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink max-buffers=1 drop=true sync=false")

    def get_by_name(self, name):
        return Source() if name == "source" else self.pipeline.get_by_name(name)

    def set_state(self, state):
        return self.pipeline.set_state(state)

    def get_bus(self):
        return self.pipeline.get_bus()


class StreamFixture:
    State = Gst.State
    SECOND = Gst.SECOND
    MapFlags = Gst.MapFlags
    MessageType = Gst.MessageType

    def parse_launch(self, description):
        assert description.startswith("pipewiresrc ")
        return Pipeline()


class PortalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bus = dbus.SessionBus(private=True)
        cls.bus.set_exit_on_disconnect(False)
        cls.name = dbus.service.BusName("org.freedesktop.portal.Desktop", cls.bus)
        cls.desktop = Desktop(cls.bus)
        cls.loop = GLib.MainLoop()
        cls.thread = threading.Thread(target=cls.loop.run, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.loop.quit()
        cls.bus.close()

    def test_grants_frames_logical_coordinates_input_and_cleanup(self):
        portal = computer.Portal()
        portal.Gst = StreamFixture()
        before = len(self.desktop.signatures)
        try:
            displays = portal.start(True)
            self.assertEqual(displays, [{"id": "42", "name": "Screen 1", "width": 400, "height": 300}])
            self.assertEqual(int(next(call[1]["types"] for call in self.desktop.calls if call[0] == "devices")), 3)
            image = portal.screenshot("42", 400)
            self.assertEqual((image["width"], image["height"]), (400, 300))
            loader = GdkPixbuf.PixbufLoader.new_with_type("jpeg")
            loader.write(base64.b64decode(image["image"]))
            loader.close()
            pixel = loader.get_pixbuf().get_pixels()[:3]
            self.assertTrue(pixel[0] > 240 and pixel[1] < 15 and pixel[2] < 15)
            computer.act(portal, {"action": "click", "displayId": "42", "x": 200, "y": 150}, displays)
            self.assertIn(("move", 42, 200.0, 150.0), self.desktop.calls)
            self.assertEqual([call for call in self.desktop.calls if call[0] == "button"][-2:], [("button", 272, 1), ("button", 272, 0)])
            computer.act(portal, {"action": "press", "key": "Control+A"}, displays)
            keys = [call for call in self.desktop.calls if call[0] == "key"][-4:]
            self.assertEqual(keys, [("key", 0xffe3, 1), ("key", ord("a"), 1), ("key", ord("a"), 0), ("key", 0xffe3, 0)])
            computer.act(portal, {"action": "type", "text": "é✓"}, displays)
            self.assertEqual([call for call in self.desktop.calls if call[0] == "key"][-4:], [("key", 233, 1), ("key", 233, 0), ("key", 0x01002713, 1), ("key", 0x01002713, 0)])
            computer.act(portal, {"action": "scroll", "displayId": "42", "x": 10, "y": 10, "deltaY": 240}, displays)
            self.assertIn(("scroll", 0.0, 240.0, True), self.desktop.calls)
            self.assertEqual(portal.pressed, set())
            self.assertEqual(portal.buttons, set())
            self.assertEqual(set(self.desktop.signatures[before:]), {
                (REMOTE, "CreateSession", "a{sv}"),
                (REMOTE, "SelectDevices", "oa{sv}"),
                (CAST, "SelectSources", "oa{sv}"),
                (REMOTE, "Start", "osa{sv}"),
                (CAST, "OpenPipeWireRemote", "oa{sv}"),
                (REMOTE, "NotifyPointerMotionAbsolute", "oa{sv}udd"),
                (REMOTE, "NotifyPointerButton", "oa{sv}iu"),
                (REMOTE, "NotifyKeyboardKeysym", "oa{sv}iu"),
                (REMOTE, "NotifyPointerAxis", "oa{sv}dd"),
            })
        finally:
            portal.stop()
        self.assertTrue(self.desktop.sessions[-1].closed)
        self.assertEqual(portal.streams, {})

    def test_view_only_uses_screencast_without_requesting_input(self):
        portal = computer.Portal()
        portal.Gst = StreamFixture()
        before = len(self.desktop.calls)
        signatures_before = len(self.desktop.signatures)
        try:
            displays = portal.start(False)
            self.assertFalse(any(call[0] == "devices" for call in self.desktop.calls[before:]))
            self.assertEqual(portal.screenshot("42", 400)["width"], 400)
            with self.assertRaisesRegex(RuntimeError, "only allows viewing"):
                computer.act(portal, {"action": "type", "text": "blocked"}, displays)
            self.assertEqual(set(self.desktop.signatures[signatures_before:]), {
                (CAST, "CreateSession", "a{sv}"),
                (CAST, "SelectSources", "oa{sv}"),
                (CAST, "Start", "osa{sv}"),
                (CAST, "OpenPipeWireRemote", "oa{sv}"),
            })
        finally:
            portal.stop()

    def test_denial_does_not_start_input_or_capture(self):
        portal = computer.Portal()
        self.desktop.deny = True
        try:
            with self.assertRaisesRegex(RuntimeError, "cancelled or denied"):
                portal.start(True)
            self.assertEqual(portal.streams, {})
        finally:
            self.desktop.deny = False
            portal.stop()


unittest.main()
