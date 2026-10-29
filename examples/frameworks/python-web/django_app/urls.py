from django.urls import path

from .views import file_metadata

urlpatterns = [path("files/<str:entry_id>", file_metadata)]
