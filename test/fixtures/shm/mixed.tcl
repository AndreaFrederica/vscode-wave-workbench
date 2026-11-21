# SPDX-License-Identifier: MPL-2.0
database -open waves -shm
probe -create -shm -database waves mixed_tb -all -depth all
run
exit
